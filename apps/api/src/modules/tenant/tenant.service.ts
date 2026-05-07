import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

interface TenantSummary {
  id: string;
  slug: string;
  displayName: string;
  lifecycleState: string;
  // Slice BG — 'on' = PMJAY-via-NHCX flow active; preauth + claim
  // submit gate on biometric verification. 'off' (default) skips
  // the gate.
  pmjayMode: string;
}

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<TenantSummary | null> {
    return this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, displayName: true, lifecycleState: true, pmjayMode: true },
    });
  }

  async findBySlug(slug: string): Promise<TenantSummary | null> {
    return this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, displayName: true, lifecycleState: true, pmjayMode: true },
    });
  }
}
