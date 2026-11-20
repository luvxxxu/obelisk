import type { Metadata } from 'next';
import { VerifyEmail } from './VerifyEmail';

export const metadata: Metadata = { title: '메일 주소 확인', referrer: 'no-referrer' };

export default function VerifyEmailPage() {
  return <VerifyEmail />;
}
