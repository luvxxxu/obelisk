import type { Metadata } from 'next';
import { AuthForm } from '../AuthForm';

export const metadata: Metadata = { title: '가입' };

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
