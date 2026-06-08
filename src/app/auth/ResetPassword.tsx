import { useState, useEffect } from 'react';
import { verifyPasswordResetCode, confirmPasswordReset } from 'firebase/auth';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { auth } from '../shared/firebase';
import '../shared/app.css';
import { PASSWORD_RULES, getStrength } from './passwordRules';

type State = 'loading' | 'form' | 'success' | 'invalid';

export const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const oobCode = searchParams.get('oobCode') ?? '';

  const [state, setState] = useState<State>('loading');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const strength = getStrength(password);

  useEffect(() => {
    if (!oobCode) { setState('invalid'); return; }
    verifyPasswordResetCode(auth, oobCode)
      .then((verifiedEmail) => { setEmail(verifiedEmail); setState('form'); })
      .catch(() => setState('invalid'));
  }, [oobCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const failedRule = PASSWORD_RULES.find(r => !r.test(password));
    if (failedRule) errs.password = failedRule.errorMsg;
    if (password !== confirmPassword) errs.confirmPassword = 'パスワードが一致しません';
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    setErrors({});
    try {
      await confirmPasswordReset(auth, oobCode, password);
      setState('success');
    } catch {
      setErrors({ form: 'パスワードの再設定に失敗しました。リンクが無効または期限切れの可能性があります。' });
    }
  };

  if (state === 'loading') {
    return (
      <div className="app-login">
        <div className="app-login-card">
          <p style={{ textAlign: 'center', color: 'var(--app-text-secondary)' }}>確認中...</p>
        </div>
      </div>
    );
  }

  if (state === 'invalid') {
    return (
      <div className="app-login">
        <div className="app-login-card">
          <h2>リンクが無効です</h2>
          <p style={{ color: 'var(--app-text-secondary)', marginBottom: '1.5rem' }}>
            このリンクは無効または期限切れです。<br />再度パスワード再設定をリクエストしてください。
          </p>
          <button className="app-toggle-btn" onClick={() => navigate('/login')}>
            ログインページへ
          </button>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="app-login">
        <div className="app-login-card">
          <h2>再設定完了</h2>
          <p className="app-settings-success" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            パスワードを更新しました。
          </p>
          <button className="app-toggle-btn" onClick={() => navigate('/login')}>
            ログインする
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-login">
      <div className="app-login-card">
        <h2>パスワード再設定</h2>
        <p style={{ color: 'var(--app-text-secondary)', fontSize: '0.875rem', marginBottom: '1rem' }}>{email}</p>
        {errors.form && <p className="app-error">{errors.form}</p>}
        <form onSubmit={handleSubmit} className="app-form" noValidate>
          <div className="app-field">
            <input
              type="password"
              placeholder="新しいパスワード"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrors(p => ({ ...p, password: '' })); }}
              className={errors.password ? 'app-input-error' : ''}
            />
            {password && (
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
          <button type="submit">パスワードを更新する</button>
        </form>
      </div>
    </div>
  );
};
