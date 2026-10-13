import { SetMetadata } from '@nestjs/common';

export type AppRole = 'super_admin' | 'admin' | 'noc' | 'viewer';

export type AuthUser = {
  sub: string;
  email: string;
  name: string;
  role: AppRole;
};

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);

const rank: Record<AppRole, number> = {
  viewer: 0,
  noc: 1,
  admin: 2,
  super_admin: 3,
};

export function roleAtLeast(role: AppRole, minimum: AppRole) {
  return rank[role] >= rank[minimum];
}

export function minimumRole(roles: AppRole[]) {
  return roles.reduce((lowest, role) => (rank[role] < rank[lowest] ? role : lowest));
}
