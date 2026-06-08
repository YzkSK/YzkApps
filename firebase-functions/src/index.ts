import { setGlobalOptions } from "firebase-functions";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { Resend } from "resend";

setGlobalOptions({ maxInstances: 10, region: "asia-northeast1" });

admin.initializeApp();

const resendApiKey = defineSecret("RESEND_API_KEY");
const appBaseUrl = defineString("APP_BASE_URL", { default: "https://yzkdev.com" });

const RESET_ERROR_CODES = {
  INVALID_ARG: "E001",
  RATE_EXCEEDED: "E002",
  SEND_FAILED: "E003",
} as const;

// パスワードリセットの送信クールダウン（5分）
const RESET_COOLDOWN_MS = 5 * 60 * 1000;

export const sendPasswordResetEmail = onCall(
  { secrets: [resendApiKey] },
  async (request) => {
    const email = request.data?.email;
    if (!email || typeof email !== "string") {
      throw new HttpsError(
        "invalid-argument",
        `メールアドレスが指定されていません [${RESET_ERROR_CODES.INVALID_ARG}]`
      );
    }

    // レート制限: 同一メールアドレスへの連続送信を防ぐ
    const db = admin.firestore();
    const emailKey = Buffer.from(email).toString("base64url");
    const rateLimitRef = db.collection("_rateLimits").doc(`pwreset_${emailKey}`);
    const now = Date.now();

    const limitDoc = await rateLimitRef.get();
    if (limitDoc.exists()) {
      const lastSent = (limitDoc.data()!.lastSent as admin.firestore.Timestamp).toMillis();
      if (now - lastSent < RESET_COOLDOWN_MS) {
        throw new HttpsError(
          "resource-exhausted",
          `しばらく時間をおいてから再試行してください [${RESET_ERROR_CODES.RATE_EXCEEDED}]`
        );
      }
    }

    // レート制限を記録（並列リクエスト対策のため generatePasswordResetLink より前に行う）
    await rateLimitRef.set({ lastSent: admin.firestore.FieldValue.serverTimestamp() });

    let oobCode: string;
    try {
      const firebaseLink = await admin.auth().generatePasswordResetLink(email);
      const parsed = new URL(firebaseLink);
      oobCode = parsed.searchParams.get("oobCode")!;
    } catch {
      // ユーザーが存在しない場合も成功を返す（メールアドレス列挙対策）
      return { success: true };
    }

    const resetLink = `${appBaseUrl.value()}/app/reset-password?oobCode=${oobCode}`;

    const resend = new Resend(resendApiKey.value());
    try {
      await resend.emails.send({
        from: "noreply@yzkdev.com",
        to: email,
        subject: "パスワードの再設定",
        html: `
          <p>パスワード再設定のリクエストを受け付けました。</p>
          <p>以下のリンクからパスワードを再設定してください。</p>
          <p><a href="${resetLink}">パスワードを再設定する</a></p>
          <p>このリンクの有効期限は1時間です。</p>
          <p>心当たりがない場合は、このメールを無視してください。</p>
        `,
      });
    } catch (e) {
      console.error(`メール送信失敗 [${RESET_ERROR_CODES.SEND_FAILED}]:`, e);
      throw new HttpsError(
        "internal",
        `メールの送信に失敗しました [${RESET_ERROR_CODES.SEND_FAILED}]`
      );
    }

    return { success: true };
  }
);
