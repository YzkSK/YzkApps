# 共有 Hooks

`src/app/shared/` に定義されている、Firestore 操作用の共通フック。

---

## useFirestoreData

Firestore からデータを読み込み、ローディング・エラー状態を管理するフック。

### シグネチャ

```typescript
function useFirestoreData<T>(opts: Options<T>): FirestoreDataResult<T>
```

### Options

| プロパティ | 型 | 必須 | 説明 |
|---|---|---|---|
| `currentUser` | `User \| null` | ✅ | Firebase Auth ユーザー。`null` の間は取得を行わない |
| `path` | `string` | ✅ | Firestore ドキュメントパス |
| `parse` | `(raw: Record<string, unknown>) => T` | ✅ | 取得データを型安全な値に変換する関数 |
| `loadingKey` | `string` | ✅ | AppLoadingContext に登録するキー名 |
| `initialData` | `T` | ✅ | 取得前のデフォルト値 |
| `onAfterLoad` | `(data: T) => void` | — | 読み込み成功後に1回だけ呼ばれるコールバック |

### 返り値 (FirestoreDataResult\<T\>)

| プロパティ | 型 | 説明 |
|---|---|---|
| `data` | `T` | 読み込まれたデータ |
| `setData` | `Dispatch<SetStateAction<T>>` | データを直接更新する setter |
| `loading` | `boolean` | 読み込み中フラグ |
| `dbError` | `boolean` | Firestore エラーフラグ |
| `setDbError` | `Dispatch<SetStateAction<boolean>>` | エラーフラグの setter |

### 動作

```
useLayoutEffect (マウント時):
  setGlobalLoading(loadingKey, true)
  → アンマウント時: setGlobalLoading(loadingKey, false)

useEffect (currentUser が確定したとき):
  currentUser === null → 早期 return（取得しない）
  cancelled = false を設定
  getDoc(doc(db, path))
  → exists: if (!cancelled) { parse(data) → setData → onAfterLoad?.(parsed) }
  → エラー: if (!cancelled) { console.error + setDbError(true) }
  → finally: if (!cancelled) { setLoading(false) + setGlobalLoading(loadingKey, false) }
  → クリーンアップ: cancelled = true（アンマウント後の setState を防ぐ）
```

`onAfterLoad` は `useRef` 経由で保持し、毎レンダーの参照変化を依存配列に含めずに吸収する。

### 使用例

```typescript
const { data: sets, setData: setSets, loading, dbError } = useFirestoreData<ProblemSet[]>({
  currentUser,
  path: firestorePaths.quizData(currentUser?.uid ?? ''),
  parse: (raw) => Array.isArray(raw.sets) ? raw.sets.map(parseProblemSet) : [],
  loadingKey: 'quiz',
  initialData: [],
  onAfterLoad: (data) => {
    if (needsMigration) saveToFirestore({ sets: data });
  },
});
```

---

## useFirestoreSave

Firestore にデータをデバウンス保存するフック。保存失敗は補助的処理のためサイレントに無視する（`console.error` は出力する）。

### シグネチャ

```typescript
function useFirestoreSave<T>(opts: Options): (data: T) => void
```

### Options

| プロパティ | 型 | 必須 | デフォルト | 説明 |
|---|---|---|---|---|
| `currentUser` | `User \| null` | ✅ | — | Firebase Auth ユーザー。`null` の場合は保存しない |
| `path` | `string` | ✅ | — | Firestore ドキュメントパス |
| `debounceMs` | `number` | — | `800` | デバウンス時間（ms） |
| `onSuccess` | `() => void` | — | — | 保存成功後に呼ばれるコールバック |

### 動作

```
呼び出し時:
  currentUser === null → 何もしない
  前回のタイマーがあれば clearTimeout で置き換え
  debounceMs 経過後: setDoc(doc(db, path), data, { merge: true })
  → 成功: if (mountedRef.current) { onSuccess?.() }
  → 失敗: console.error（サイレント無視。次回操作時に再試行される）
```

- `onSuccess` は `useRef` 経由で保持し、毎レンダーの参照変化を吸収する
- `mountedRef` によりアンマウント後に `onSuccess` が呼ばれない（setState を含む場合に安全）
- データ損失防止のためアンマウント後も `setDoc` 自体は実行される（タイマーは cancel しない）

### 使用例

```typescript
// Quiz.tsx
const saveToFirestore = useFirestoreSave<{ sets: ProblemSet[] }>({
  currentUser,
  path: firestorePaths.quizData(currentUser?.uid ?? ''),
});
saveToFirestore({ sets: next });

// Timetable.tsx（保存後に通知予定を再計算）
const saveToFirestore = useFirestoreSave<TimetableData>({
  currentUser,
  path: firestorePaths.timetableData(currentUser?.uid ?? ''),
  onSuccess: () => setTokenVersion(v => v + 1),
});
```

---

## テスト

### 結合テスト — `src/__tests__/integration/shared/useFirestoreData.test.tsx`

| テスト名 | 結果 |
|---|---|
| currentUser が null の場合は getDoc を呼ばず loading=true のまま | ✅ |
| ドキュメントが存在する場合は data に parse 結果がセットされる | ✅ |
| ドキュメントが存在しない場合は initialData のまま | ✅ |
| Firestore エラー時は dbError=true になる | ✅ |
| onAfterLoad がロード成功後に呼ばれる | ✅ |
| setData で data を直接更新できる | ✅ |

### 結合テスト — `src/__tests__/integration/shared/useFirestoreSave.test.tsx`

| テスト名 | 結果 |
|---|---|
| currentUser が null の場合は setDoc を呼ばない | ✅ |
| debounceMs 経過後に setDoc が呼ばれる | ✅ |
| debounce 中に連続呼び出しすると最後の呼び出しのみ保存される | ✅ |
| 保存成功後に onSuccess が呼ばれる | ✅ |
| setDoc が失敗しても onSuccess は呼ばれない（console.error のみ） | ✅ |
| アンマウント後に onSuccess は呼ばれない | ✅ |
