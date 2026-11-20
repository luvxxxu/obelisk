import type { Metadata } from 'next';
import { ClaimAdmin } from './ClaimAdmin';

export const metadata: Metadata = { title: '서버 운영자 되기', referrer: 'no-referrer' };

export default function ClaimAdminPage() {
  return <ClaimAdmin />;
}
