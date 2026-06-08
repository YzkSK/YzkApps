// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { usePageTitle } from '@/app/shared/usePageTitle';

afterEach(() => {
  cleanup();
  document.title = 'YzkApps'; // 念のためリセット
});

const TitleComponent = ({ title }: { title: string }) => {
  usePageTitle(title);
  return null;
};

describe('usePageTitle (結合テスト)', () => {
  it('マウント時に document.title が指定タイトルになる', () => {
    render(<TitleComponent title="ダッシュボード" />);
    expect(document.title).toBe('ダッシュボード');
  });

  it('アンマウント時に document.title が "YzkApps" に戻る', () => {
    const { unmount } = render(<TitleComponent title="設定" />);
    expect(document.title).toBe('設定');
    act(() => unmount());
    expect(document.title).toBe('YzkApps');
  });

  it('title が変わると document.title も更新される', () => {
    const { rerender } = render(<TitleComponent title="クイズ" />);
    expect(document.title).toBe('クイズ');
    rerender(<TitleComponent title="時間割" />);
    expect(document.title).toBe('時間割');
  });
});
