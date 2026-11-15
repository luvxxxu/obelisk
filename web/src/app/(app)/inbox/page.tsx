'use client';

import { selectView } from '@obelisk/core';
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { buttonClass } from '@/components/primitives';
import { QuickAdd } from '@/components/QuickAdd';
import { EmptyState, Page, TaskGroup, ViewHeader } from '@/components/View';
import { useTasks } from '@/lib/hooks';
import { useApp } from '@/lib/store';
import { setUi } from '@/lib/ui-state';

export default function InboxPage() {
  const { today } = useApp();
  const tasks = useTasks();
  const list = useMemo(() => selectView(tasks, 'inbox', today), [tasks, today]);

  return (
    <Page>
      <ViewHeader
        icon="inbox"
        title="인박스"
        description="프로젝트 없이 담아 둔 작업이에요. 떠오르는 대로 적고, 나중에 날짜와 프로젝트를 정해 주세요."
      />
      <QuickAdd projectId={null} />
      <TaskGroup tasks={list} showProject={false} />
      {list.length === 0 && (
        <EmptyState
          icon="inbox"
          title="인박스가 비어 있어요"
          body="머릿속에 떠다니는 일을 모두 여기에 꺼내 두세요. 정리는 나중에 해도 돼요."
          action={
            <button type="button" className={buttonClass({ variant: 'outline', size: 'sm' })} onClick={() => setUi({ quickAdd: true })}>
              <Icon name="plus" size={15} />
              새 작업
              <kbd>N</kbd>
            </button>
          }
        />
      )}
    </Page>
  );
}
