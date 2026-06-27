import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { DriveFile } from '../constants';

type Props = {
  file: DriveFile;
  onDelete: () => Promise<void>;
  onClose: () => void;
  description?: string;
  confirmLabel?: string;
};

export const DeleteModal = ({ file, onDelete, onClose, description, confirmLabel }: Props) => {
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    setLoading(true);
    try {
      await onDelete();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={open => { if (!open && !loading) onClose(); }}>
      <DialogContent className="max-w-[420px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>動画を削除</DialogTitle>
        </DialogHeader>
        <p style={{ fontSize: 13, color: 'var(--vc-text-secondary)', margin: 0 }}>
          <strong style={{ color: 'var(--app-text)', fontWeight: 600 }}>{file.name}</strong><br />
          {description ?? 'をゴミ箱に移動します。この操作は Google Drive のゴミ箱から元に戻せます。'}
        </p>
        <div className="flex gap-2 mt-2">
          <Button variant="outline" className="flex-1" onClick={onClose} disabled={loading}>
            キャンセル
          </Button>
          <Button
            variant="default"
            className="flex-[2]"
            style={{ background: '#ef4444', color: '#fff' }}
            onClick={handleDelete}
            disabled={loading}
          >
            {loading ? '削除中…' : (confirmLabel ?? 'ゴミ箱に移動')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
