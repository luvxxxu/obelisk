import type { Metadata } from 'next';
import { ResetPassword } from './ResetPassword';

export const metadata: Metadata = { title: '새 비밀번호', referrer: 'no-referrer' };

export default function ResetPasswordPage() {
  return <ResetPassword />;
}
