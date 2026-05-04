import { type AppPermission } from '@claims/contracts';
import { SetMetadata } from '@nestjs/common';

// Marks a route handler as requiring one or more permissions. The RolesGuard
// reads this metadata and 403s if the user's effective permission set
// (union across all assigned roles) doesn't contain ALL listed permissions.
//
// Example:
//   @Post('users')
//   @RequirePermission(Permissions.USER_INVITE)
//   invite(...)
//
// Multiple permissions are AND-combined. For OR semantics, split into
// separate routes — explicit beats clever.
export const REQUIRE_PERMISSION_KEY = 'claims:require-permission';

export const RequirePermission = (
  ...permissions: AppPermission[]
): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permissions);
