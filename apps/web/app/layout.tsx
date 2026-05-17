import './globals.css';

import { type Metadata } from 'next';
import { type ReactNode } from 'react';

import { ConfirmDialogProvider } from '../components/modals/ConfirmDialog/ConfirmDialogProvider';
import { ErrorModalProvider } from '../components/modals/ErrorModal/ErrorModalProvider';
import { ToastProvider } from '../components/toast/ToastProvider';
import { QueryProvider } from '../lib/providers/QueryProvider';

export const metadata: Metadata = {
  title: 'DigiSparsh Claims Platform',
  description: 'Claims processing for Indian hospitals',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <ErrorModalProvider>
            <ConfirmDialogProvider>
              <ToastProvider>{children}</ToastProvider>
            </ConfirmDialogProvider>
          </ErrorModalProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
