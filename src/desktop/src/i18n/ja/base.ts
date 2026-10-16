// Japanese for the base part of the OS (English text -> Japanese).
// Shared models and words: purposes, "/", fetching, repos, and the words
// several pages use alike.
export default {
  // purposes.ts: the rail's places (labels other than New repo stay as names)
  'Profile': 'プロフィール',
  'A page that reads the same to you and to anyone else, with your repos and posts.': '自分にも他人にも同じ形で見えるページ。repoと投稿が並ぶ。',
  'Your workshop': '自分の作業場',
  'Edit the files of the repos in the band as one continuous page, with Reference and Prompt on the right.': '帯に出したrepoのfileを、一続きのページで編集する。右に参照とPrompt。',
  'The tree of /': '/ のtree',
  'Opens the whole system\'s / over the current page. Choosing something inside a repo opens it there in Forge.': 'システム全体の / を、今のページに重ねて開く。repoの中を選ぶとForgeでそこを開く。',
  'Issues and commits': 'Issue とコミット',
  'Commit changes Issue by Issue and submit them. Changes that come in are settled with Merge or Reject.': 'Issue ごとに変更を Commit し、提出する。届いた変更は Merge か Reject で決める。',
  'This device and its environments': 'この端末と環境',
  'What this device holds, largest first. What can be freed is freed right there. The active environments too.': 'この端末が持っているものを容量順に。空けられるものはその場で空ける。有効な環境も。',
  'The canonical copy': '正本',
  'Where the canonical copy lives. What you change is sent at once, and committing makes it history. Devices and passkeys are here too.': '正本を置く場所。変えたものはすぐ送られ、Commit すると履歴になる。端末とパスキーもここで。',
  'Simple posts': 'シンプルな投稿',
  'Share short things, like what is popular lately.': '最近の流行りなどを短く共有する。',
  'Typed messages to you': '自分に届く型付きメッセージ',
  'Review requests, submitted changes, questions and more, each with what it is about and what to do.': 'レビュー依頼・変更提出・質問などを、対象と対応操作つきで受け取る。',
  'New repo': '新しいrepo',
  'Make a repo': 'repoの作成',
  'Choose a standard repo template and make it as an independent repo.': '標準的なrepoテンプレートを選び、独立したrepoとして作る。',

  // system.ts: where each top-level directory of "/" comes from
  'distribution': '配布',
  'kernel': 'カーネル',
  'repo': 'repo',
  'empty': '空',
  'The distribution has not been fetched': '配布物を取得していません',

  // fetch.ts: why a download is being taken up again
  'Could not receive the rest': '続きを受け取れませんでした',
  'The size does not match': '大きさが合いません',
  'The contents do not match': '中身が合いません',
  'The connection stalled': '回線が止まりました',
  'The connection broke': '回線が切れました',
  'Could not load': '読み込めませんでした',

  // repos.ts
  '{path}: a file is in the way': '{path}: 途中がファイルです',
  '{path}: a folder is there': '{path}: フォルダーがあります',

  // repo templates (shared/templates.json labels)
  'Standard': '標準',
  'Minimal': '最小',

  // Words several pages share
  'Commit': 'Commit',
  'Name': '名前',
  'Save': '保存',
  'Cancel': 'キャンセル',
  'Create': '作成',
  'Detail': '詳細',
  'Binary': 'バイナリ',
  'Open in Forge': 'Forge で開く',
  'Could not save: {message}': '保存できませんでした: {message}',
  '{n} file': '{n} ファイル',
  '{n} files': '{n} ファイル',
  '{n} line': '{n} 行',
  '{n} lines': '{n} 行',
  '{n} more line': 'ほか {n} 行',
  '{n} more lines': 'ほか {n} 行',
} as Record<string, string>;
