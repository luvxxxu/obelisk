'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { openTaskLink } from '@/lib/store';

/** Stable link to a task (used by AI tools): opens it in the app. */
export default function TaskLink() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace('/all');
    // The task may live in another workspace (an org): open that one first.
    void openTaskLink(id);
  }, [id, router]);
  return null;
}
