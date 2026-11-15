'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { selectTask } from '@/lib/store';

/** Stable link to a task (used by AI tools): opens it in the app. */
export default function TaskLink() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    selectTask(id);
    router.replace('/all');
  }, [id, router]);
  return null;
}
