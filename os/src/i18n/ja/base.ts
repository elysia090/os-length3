// Japanese for the base part of the OS (English text -> Japanese).
// Shared models and words: purposes, "/", fetching, repos, and the words
// several pages use alike.
export default {
  // purposes.ts: the rail's places (labels other than New repo stay as names)
  'Profile': 'プロフィール',
  'A public profile page showing your repos and servers.': 'あなたや他のユーザーに公開される、repo とサーバーの一覧ページ。',
  'Workspace': 'ワークスペース',
  'Edit files from repos in the band in a continuous view, with Reference and Prompt on the right.': 'バンド内の repo ファイルを連続表示で編集。右側に参照と Prompt を配置。',
  'Directory tree (/)': '/ のツリー',
  'Opens the system root (/) over the current page. Selecting a repo file opens it in Forge.': 'システム全体の / を重ねて表示。repo 内の項目を選択すると Forge で開きます。',
  'Issues and commits': 'Issue とコミット',
  'Work by Issue: commit, push, and submit to main as a Change. Review incoming Changes to Merge or Reject.':
    'Issue 単位で作業：コミット・プッシュして Change として main に提出。届いた Change はマージまたはリジェクトで処理。',
  'This device and environments': 'このデバイスと環境',
  'Storage usage by size. Free up space instantly. Manage active environments.': 'ストレージ容量順に表示。不要なデータはその場で解放可能。有効な環境も管理。',
  'Repo storage': 'repo の保管場所',
  'Where your repos are kept. Changes sync instantly; commits record history. Manage devices and passkeys.':
    'repo の保管場所。変更は即座に同期され、コミットで履歴を記録。デバイスやパスキーもここで管理。',
  'Notifications': '受信メッセージ',
  'Review requests, Changes, and questions, with context and action items.': 'レビュー依頼、Change、質問などを受信。対象と必要な操作を表示。',
  'Plugin': 'プラグイン',
  'Optional plugins': '拡張プラグイン',
  'Opens the top plugin bar. Hidden until toggled; holds up to seven plugins side by side.': '画面上部にプラグインバーを展開。開くまで非表示、最大7つまで並べて表示可能。',
  'New repo': '新規 repo',
  'Create a repo': 'repo を作成',
  'Choose a standard template to create a standalone repo.': '標準テンプレートを選び、独立した repo として作成。',

  // system.ts: where each top-level directory of "/" comes from
  'distribution': 'ディストリビューション',
  'kernel': 'カーネル',
  'repo': 'repo',
  'repos': 'repo',
  'server': 'サーバー',
  'servers': 'サーバー',
  'empty': '空',
  'Distribution not fetched': 'ディストリビューションが取得されていません',

  // prompt/l3-files.ts: why a download is being taken up again
  'Failed to receive remainder': '残りのデータを受信できませんでした',
  'Size mismatch': 'サイズが一致しません',
  'Content mismatch': '内容が一致しません',
  'Connection timed out': '接続がタイムアウトしました',
  'Connection lost': '接続が切断されました',
  'Failed to load': '読み込めませんでした',

  // repos.ts

  // repo templates (shared/templates.json labels)
  'Standard': '標準',

  // Words several pages share
  'Commit': 'コミット',
  'Name': '名前',
  'Save': '保存',
  'Cancel': 'キャンセル',
  'Create': '作成',
  'Detail': '詳細',
  'Binary': 'バイナリ',
  'Open in Forge': 'Forge で開く',
  'Failed to save: {message}': '保存できませんでした：{message}',
  '{n} file': '{n}ファイル',
  '{n} files': '{n}ファイル',
  '{n} line': '{n}行',
  '{n} lines': '{n}行',
  '{n} more line': '他{n}行',
  '{n} more lines': '他{n}行',
} as Record<string, string>;
