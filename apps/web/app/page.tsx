import { redirect } from 'next/navigation';

export default function Index(): never {
  // Skeleton route: always send users to /login. The login page itself will
  // forward to /dashboard if a session cookie is already valid.
  redirect('/login');
}
