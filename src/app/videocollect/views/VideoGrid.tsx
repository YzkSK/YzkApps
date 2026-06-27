import type { DriveFile } from '../constants';
import { VideoCard } from './VideoCard';

type Props = {
  files: DriveFile[];
  tags: Record<string, string[]>;
  accessToken: string;
  playingId: string | null;
  previewingId: string | null;
  offlineIds?: Set<string>;
  onPreviewChange: (id: string | null) => void;
  onTagEdit: (file: DriveFile) => void;
  onRename: (file: DriveFile) => void;
  onDelete: (file: DriveFile) => void;
  onOfflineDelete?: (file: DriveFile) => void;
};

export const VideoGrid = ({ files, tags, accessToken, playingId, previewingId, offlineIds, onPreviewChange, onTagEdit, onRename, onDelete, onOfflineDelete }: Props) => (
  <div className="vc-grid">
    {files.map(file => (
      <VideoCard
        key={file.id}
        file={file}
        tags={tags[file.id] ?? []}
        accessToken={accessToken}
        isPlaying={file.id === playingId}
        isPreviewing={file.id === previewingId}
        isOffline={offlineIds?.has(file.id)}
        onPreviewChange={onPreviewChange}
        onTagEdit={onTagEdit}
        onRename={onRename}
        onDelete={onDelete}
        onOfflineDelete={onOfflineDelete}
      />
    ))}
  </div>
);
