import { z } from 'zod';

export const TenantLifecycleStateSchema = z.enum([
  'CONTRACTED',
  'PROVISIONING',
  'IN_SETUP',
  'PILOT',
  'LIVE',
  'SUSPENDED',
  'CHURNED',
]);
export type TenantLifecycleState = z.infer<typeof TenantLifecycleStateSchema>;

export const TenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1).max(64),
  displayName: z.string().min(1).max(256),
  lifecycleState: TenantLifecycleStateSchema,
});
export type Tenant = z.infer<typeof TenantSchema>;
