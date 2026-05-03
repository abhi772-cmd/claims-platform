import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<{
    id: string;
    slug: string;
    displayName: string;
    lifecycleState: string;
  } | null> {
    return this.prisma.tenant.findUnique({
      where: { id },
      select: { id: true, slug: true, displayName: true, lifecycleState: true },
    });
  }

  async findBySlug(slug: string): Promise<{
    id: string;
    slug: string;
    displayName: string;
    lifecycleState: string;
  } | null> {
    return this.prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, displayName: true, lifecycleState: true },
    });
  }
}
