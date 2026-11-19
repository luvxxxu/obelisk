import type { Metadata } from 'next';
import { ForgotPassword } from './ForgotPassword';

export const metadata: Metadata = { title: '비밀번호 찾기' };

export default function ForgotPasswordPage() {
  return <ForgotPassword />;
}
