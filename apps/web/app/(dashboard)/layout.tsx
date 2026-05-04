import { type ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="flex h-16 items-center border-b border-neutral-200 bg-neutral-0 px-6">
        <h1 className="text-base font-semibold text-neutral-800">DigiSparsh Claims</h1>
      </header>
      <main className="px-6 py-8">{children}</main>
    </div>
  );
}
