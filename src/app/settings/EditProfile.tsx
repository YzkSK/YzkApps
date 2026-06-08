import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../shared/app.css';
import { EMAIL_REGEX } from '../shared/validators';
import {
  updateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../shared/firebase';
import { useAuth } from '../auth/AuthContext';
import { AppLayout } from '../platform/AppLayout';

const Section = ({
  title,
  onSubmit,
  success,
  error,
  children,
}: {
  title: string;
  onSubmit: (e: React.FormEvent) => void;
  success?: string;
  error?: string;
  children: React.ReactNode;
}) => (
  <section className="app-settings-section">
    <h3 className="app-settings-section-title">{title}</h3>
    {error && <p className="app-error">{error}</p>}
    {success && <p className="app-settings-success">{success}</p>}
    <form onSubmit={onSubmit} className="app-form" noValidate>
      {children}
    </form>
  </section>
);

export const EditProfile = () => {
  const { currentUser, username: currentUsername } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState(currentUsername ?? '');
  const [usernameMsg, setUsernameMsg] = useState({ error: '', success: '' });

  const [newEmail, setNewEmail] = useState('');
  const [emailStep, setEmailStep] = useState<'input' | 'confirm'>('input');
  const [emailConfirmPassword, setEmailConfirmPassword] = useState('');
  const [emailMsg, setEmailMsg] = useState({ error: '', success: '' });

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordStep, setPasswordStep] = useState<'input' | 'confirm'>('input');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [passwordMsg, setPasswordMsg] = useState({ error: '', success: '' });

  const reauth = async (password: string) => {
    if (!currentUser?.email) throw new Error('ユーザー情報が取得できません');
    const credential = EmailAuthProvider.credential(currentUser.email, password);
    await reauthenticateWithCredential(currentUser, credential);
  };

  const handleUsername = async (e: React.FormEvent) => {
    e.preventDefault();
    setUsernameMsg({ error: '', success: '' });
    if (!username.trim()) {
      setUsernameMsg({ error: 'ユーザー名を入力してください', success: '' });
      return;
    }
    try {
      await setDoc(
        doc(db, 'users', currentUser!.uid, 'profile', 'data'),
        { username: username.trim(), id: currentUser!.uid },
        { merge: true },
      );
      setUsernameMsg({ error: '', success: 'ユーザー名を更新しました' });
    } catch {
      setUsernameMsg({ error: 'ユーザー名の更新に失敗しました', success: '' });
    }
  };

  const handleEmailInput = (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMsg({ error: '', success: '' });
    if (!newEmail.trim()) {
      setEmailMsg({ error: 'メールアドレスを入力してください', success: '' });
      return;
    }
    if (!EMAIL_REGEX.test(newEmail)) {
      setEmailMsg({ error: 'メールアドレスの形式が正しくありません', success: '' });
      return;
    }
    setEmailStep('confirm');
  };

  const handleEmailConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailMsg({ error: '', success: '' });
    if (!emailConfirmPassword) {
      setEmailMsg({ error: 'パスワードを入力してください', success: '' });
      return;
    }
    try {
      await reauth(emailConfirmPassword);
      await updateEmail(currentUser!, newEmail.trim());
      setNewEmail('');
      setEmailConfirmPassword('');
      setEmailStep('input');
      setEmailMsg({ error: '', success: 'メールアドレスを更新しました' });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? '';
      const msg =
        code === 'auth/wrong-password' || code === 'auth/invalid-credential'
          ? 'パスワードが違います'
          : code === 'auth/email-already-in-use'
          ? 'このメールアドレスはすでに使用されています'
          : 'メールアドレスの更新に失敗しました';
      setEmailMsg({ error: msg, success: '' });
    }
  };

  const handlePasswordInput = (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg({ error: '', success: '' });
    if (!newPassword) {
      setPasswordMsg({ error: '新しいパスワードを入力してください', success: '' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMsg({ error: 'パスワードが一致しません', success: '' });
      return;
    }
    setPasswordStep('confirm');
  };

  const handlePasswordConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg({ error: '', success: '' });
    if (!passwordConfirm) {
      setPasswordMsg({ error: 'パスワードを入力してください', success: '' });
      return;
    }
    try {
      await reauth(passwordConfirm);
      await updatePassword(currentUser!, newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setPasswordConfirm('');
      setPasswordStep('input');
      setPasswordMsg({ error: '', success: 'パスワードを更新しました' });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? '';
      const msg =
        code === 'auth/wrong-password' || code === 'auth/invalid-credential'
          ? '現在のパスワードが違います'
          : 'パスワードの更新に失敗しました';
      setPasswordMsg({ error: msg, success: '' });
    }
  };

  return (
    <AppLayout
      pageClassName="app-settings"
      className="app-settings-main"
      title="ユーザー情報の変更"
      headerActions={
        <button onClick={() => navigate('/settings')} className="app-logout-btn">戻る</button>
      }
    >
        <Section title="ユーザー名" onSubmit={handleUsername} {...usernameMsg}>
          <div className="app-field">
            <input
              type="text"
              placeholder="ユーザー名"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <button type="submit">更新</button>
        </Section>

        {emailStep === 'input' ? (
          <Section title="メールアドレス" onSubmit={handleEmailInput} {...emailMsg}>
            <div className="app-field">
              <input
                type="email"
                placeholder="新しいメールアドレス"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </div>
            <button type="submit">更新</button>
          </Section>
        ) : (
          <Section title="メールアドレス" onSubmit={handleEmailConfirm} {...emailMsg}>
            <p className="app-settings-confirm-label">本人確認のため現在のパスワードを入力してください</p>
            <div className="app-field">
              <input
                type="password"
                placeholder="現在のパスワード"
                value={emailConfirmPassword}
                onChange={(e) => setEmailConfirmPassword(e.target.value)}
                autoFocus
              />
            </div>
            <button type="submit">確認して更新</button>
            <button type="button" className="app-settings-cancel" onClick={() => { setEmailStep('input'); setEmailConfirmPassword(''); setEmailMsg({ error: '', success: '' }); }}>
              キャンセル
            </button>
          </Section>
        )}

        {passwordStep === 'input' ? (
          <Section title="パスワード" onSubmit={handlePasswordInput} {...passwordMsg}>
            <div className="app-field">
              <input
                type="password"
                placeholder="新しいパスワード"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="app-field">
              <input
                type="password"
                placeholder="新しいパスワード（確認）"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <button type="submit">更新</button>
          </Section>
        ) : (
          <Section title="パスワード" onSubmit={handlePasswordConfirm} {...passwordMsg}>
            <p className="app-settings-confirm-label">本人確認のため現在のパスワードを入力してください</p>
            <div className="app-field">
              <input
                type="password"
                placeholder="現在のパスワード"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                autoFocus
              />
            </div>
            <button type="submit">確認して更新</button>
            <button type="button" className="app-settings-cancel" onClick={() => { setPasswordStep('input'); setPasswordConfirm(''); setPasswordMsg({ error: '', success: '' }); }}>
              キャンセル
            </button>
          </Section>
        )}
    </AppLayout>
  );
};
