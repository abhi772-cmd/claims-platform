import { Injectable, Logger } from '@nestjs/common';

import { type CidrRange, parseCidr, ipMatchesAny } from './cidr.util';
import { IpNotAllowedError } from '../../common/errors/auth-errors';
import { ValidationFailedError } from '../../common/errors/validation-errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditEvents, AuditService } from '../audit';

const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class IpAllowlistService {
  private readonly log = new Logger(IpAllowlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // Read tenant CIDRs (raw strings, suitable for the editor UI).
  async list(tenantId: string): Promise<string[]> {
    const tenant = await this.prisma.runInTenantContext(
      PLATFORM_TENANT,
      'platform_admin',
      (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { ipAllowlist: true } }),
    );
    return parseStored(tenant?.ipAllowlist);
  }

  async update(
    tenantId: string,
    actorUserId: string,
    cidrs: string[],
    actorIp: string | null,
    actorUserAgent: string | null,
  ): Promise<string[]> {
    // Validate every entry strictly. Reject the whole update if any one
    // is malformed so the tenant can't accidentally lock itself out with
    // a typo'd CIDR they thought was applied.
    const errors: Record<string, string[]> = {};
    const normalised: string[] = [];
    cidrs.forEach((raw, i) => {
      const parsed = parseCidr(raw);
      if (!parsed) {
        errors[`cidrs.${i}`] = [`Not a valid IP or CIDR: "${raw}"`];
      } else {
        normalised.push(parsed.raw);
      }
    });
    if (Object.keys(errors).length > 0) {
      throw new ValidationFailedError(errors);
    }

    return this.prisma.runInTenantContext(tenantId, 'tenant', async (tx) => {
      const before = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { ipAllowlist: true },
      });
      const updated = await tx.tenant.update({
        where: { id: tenantId },
        data: { ipAllowlist: normalised as never },
        select: { ipAllowlist: true },
      });
      await this.audit.recordWithTx(tx, {
        tenantId,
        actorUserId,
        actorType: 'user',
        action: AuditEvents.TENANT_IP_ALLOWLIST_UPDATED,
        resourceType: 'tenant',
        resourceId: tenantId,
        before: { cidrs: parseStored(before?.ipAllowlist) },
        after: { cidrs: normalised },
        ipAddress: actorIp,
        userAgent: actorUserAgent,
      });
      return parseStored(updated.ipAllowlist);
    });
  }

  // Enforcement check at login. Skipped for the platform_admin role and
  // for tenants with an empty allowlist. Throws IpNotAllowedError when
  // the request IP doesn't match any CIDR in the tenant's list.
  async assertAllowed(tenantId: string, ip: string | null, isPlatformAdmin: boolean): Promise<void> {
    if (isPlatformAdmin) return;
    if (!ip) return; // We don't fail closed on a missing IP — log instead.
    const normalised = normaliseIp(ip);
    const cidrs = await this.list(tenantId);
    if (cidrs.length === 0) return;
    const ranges: CidrRange[] = [];
    for (const c of cidrs) {
      const r = parseCidr(c);
      if (r) ranges.push(r);
    }
    if (!ipMatchesAny(normalised, ranges)) {
      this.log.warn(`ip not allowed tenantId=${tenantId} ip=${ip} normalised=${normalised}`);
      throw new IpNotAllowedError();
    }
  }
}

// Express returns IPv4-mapped IPv6 strings ("::ffff:127.0.0.1") for any
// IPv4 client when the server isn't bound to a strict IPv4 socket. Match
// those against IPv4 CIDRs by stripping the prefix — otherwise an admin
// allowing 203.0.113.0/24 would accidentally block their IPv4 office.
function normaliseIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const rest = ip.slice('::ffff:'.length);
    if (rest.includes('.')) return rest;
  }
  return ip;
}

function parseStored(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
