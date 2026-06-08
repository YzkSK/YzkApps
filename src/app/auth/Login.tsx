import { useState } from 'react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { useNavigate } from 'react-router-dom';
import '../shared/app.css';
import { auth, db, functions } from '../shared/firebase';
import { PASSWORD_RULES, getStrength } from './passwordRules';
import { EMAIL_REGEX } from '../shared/validators';

const FIREBASE_ERRORS: Record<string, string> = {
  'auth/user-not-found': 'メールアドレスまたはパスワードが違います',
  'auth/wrong-password': 'メールアドレスまたはパスワードが違います',
  'auth/invalid-credential': 'メールアドレスまたはパスワードが違います',
  'auth/email-already-in-use': 'このメールアドレスはすでに使用されています',
  'auth/too-many-requests': 'ログイン試行が多すぎます。しばらく待ってから再試行してください',
  'auth/network-request-failed': 'ネットワークエラーが発生しました',
};

export const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [isReset, setIsReset] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();

  const strength = getStrength(password);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!email.trim()) {
      e.email = 'メールアドレスを入力してください';
    } else if (!EMAIL_REGEX.test(email)) {
      e.email = 'メールアドレスの形式が正しくありません';
    }
    if (!password) {
      e.password = 'パスワードを入力してください';
    } else if (isSignUp) {
      const failedRule = PASSWORD_RULES.find(r => !r.test(password));
      if (failedRule) e.password = failedRule.errorMsg;
    }
    if (isSignUp) {
      if (!username.trim()) {
        e.username = 'ユーザー名を入力してください';
      }
      if (!confirmPassword) {
        e.confirmPassword = '確認用パスワードを入力してください';
      } else if (password !== confirmPassword) {
        e.confirmPassword = 'パスワードが一致しません';
      }
    }
    return e;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});
    try {
      if (isSignUp) {
        const { user } = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(
          doc(db, 'users', user.uid, 'profile', 'data'),
          { username: username.trim(), id: user.uid },
          { merge: true },
        );
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      navigate('/dashboard');
    } catch (err: unknown) {
      if (err instanceof Error) {
        const code = (err as { code?: string }).code ?? '';
        setErrors({ form: FIREBASE_ERRORS[code] ?? err.message });
      }
    }
  };

  const switchMode = () => {
    setIsSignUp(!isSignUp);
    setIsReset(false);
    setResetSent(false);
    setErrors({});
    setConfirmPassword('');
    setUsername('');
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    if (!email.trim()) { setErrors({ email: 'メールアドレスを入力してください' }); return; }
    try {
      const fn = httpsCallable(functions, 'sendPasswordResetEmail');
      await fn({ email: email.trim() });
      setResetSent(true);
    } catch {
      setErrors({ form: 'メールの送信に失敗しました。メールアドレスを確認してください' });
    }
  };

  if (isReset) {
    return (
      <div className="app-login">
        <div className="app-login-card">
          <h2>パスワード再設定</h2>
          {resetSent ? (
            <>
              <p className="app-settings-success" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                再設定メールを送信しました。<br />メールをご確認ください。
              </p>
              <button className="app-toggle-btn" onClick={() => { setIsReset(false); setResetSent(false); setEmail(''); }}>
                ログインに戻る
              </button>
            </>
          ) : (
            <>
              {errors.form && <p className="app-error">{errors.form}</p>}
              <form onSubmit={handleReset} className="app-form" noValidate>
                <div className="app-field">
                  <input
                    type="email"
                    placeholder="メールアドレス"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setErrors({}); }}
                    className={errors.email ? 'app-input-error' : ''}
                  />
                  {errors.email && <span className="app-field-error">{errors.email}</span>}
                </div>
                <button type="submit">再設定メールを送信</button>
              </form>
              <p className="app-toggle">
                <button onClick={() => { setIsReset(false); setErrors({}); }}>ログインに戻る</button>
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-login">
      <div className="app-login-card">
        <h2>{isSignUp ? '新規登録' : 'ログイン'}</h2>
        {errors.form && <p className="app-error">{errors.form}</p>}
        <form onSubmit={handleSubmit} className="app-form" noValidate>
          {isSignUp && (
            <div className="app-field">
              <input
                type="text"
                placeholder="ユーザー名"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setErrors(p => ({ ...p, username: '' })); }}
                className={errors.username ? 'app-input-error' : ''}
              />
              {errors.username && <span className="app-field-error">{errors.username}</span>}
            </div>
          )}
          <div className="app-field">
            <input
              type="email"
              placeholder="メールアドレス"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setErrors(p => ({ ...p, email: '' })); }}
              className={errors.email ? 'app-input-error' : ''}
            />
            {errors.email && <span className="app-field-error">{errors.email}</span>}
          </div>
          <div className="app-field">
            <input
              type="password"
              placeholder="パスワード"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrors(p => ({ ...p, password: '' })); }}
              className={errors.password ? 'app-input-error' : ''}
            />
            {isSignUp && password && (
              <div className="app-strength">
                <div className="app-strength-bar">
                  {[1, 2, 3, 4].map(i => (
                    <div
                      key={i}
                      className="app-strength-segment"
                      style={{ background: i <= strength.score ? strength.color : '#333' }}
                    />
                  ))}
                </div>
                <span className="app-strength-label" style={{ color: strength.color }}>
                  {strength.label}
                </span>
              </div>
            )}
            {errors.password && <span className="app-field-error">{errors.password}</span>}
          </div>
          {isSignUp && (
            <div className="app-field">
              <input
                type="password"
                placeholder="パスワード（確認）"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setErrors(p => ({ ...p, confirmPassword: '' })); }}
                className={errors.confirmPassword ? 'app-input-error' : ''}
              />
              {errors.confirmPassword && <span className="app-field-error">{errors.confirmPassword}</span>}
            </div>
          )}
          <button type="submit">{isSignUp ? '登録する' : 'ログイン'}</button>
        </form>
        <p className="app-toggle">
          {isSignUp ? 'すでにアカウントをお持ちの方は' : 'アカウントをお持ちでない方は'}
          <button onClick={switchMode}>
            {isSignUp ? 'ログイン' : '新規登録'}
          </button>
        </p>
        {!isSignUp && (
          <p className="app-toggle">
            <button onClick={() => { setIsReset(true); setErrors({}); }}>
              パスワードをお忘れの方
            </button>
          </p>
        )}
      </div>
    </div>
  );
};
