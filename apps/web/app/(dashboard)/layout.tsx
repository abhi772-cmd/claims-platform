import { type ReactNode } from 'react';

import { DashboardChrome } from '../../components/dashboard/DashboardChrome';

export default function DashboardLayout({ children }: { children: ReactNode }): JSX.Element {
  return <DashboardChrome>{children}</DashboardChrome>;
}
