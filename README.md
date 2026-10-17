# 매일매일 CS v2

개인 학습용 Daily CS 서비스입니다. 공개 저장소에는 정적 앱, 빌드 도구, 문서, 테스트만 둡니다. 실제 수신자 이메일, Supabase 키, Google 계정 정보, 백업 데이터, 원본 365개 비공개 콘텐츠는 저장소에 넣지 않습니다.

## 서비스 개요

- 시작일: 2026-09-15 KST
- 대상 사용자: Google 로그인으로 허용된 소유자 1명
- 공개 배포: GitHub Pages가 `dist/` 정적 파일만 배포
- 비공개 기능: 읽기, 검색, 일정, CRUD, 메일 상태, 백업/복구는 모두 Supabase Owner API 뒤에 둠
- 메일 발송: 기존 Google Apps Script 프로젝트가 mail 전용 machine key로 `mail-api`만 호출
- 백업: 별도 private archive 저장소에서 export-only key로 실행

## 아키텍처

```text
GitHub Pages public app
  -> Supabase Auth Google login
  -> Supabase Edge owner-api
  -> Postgres owner-only private data

Google Apps Script
  -> Supabase Edge mail-api
  -> MailApp sends one private recipient email

Private archive workflow
  -> Supabase Edge backup-api
  -> private JSON backup files outside public repo
```

프론트엔드는 공개될 수 있는 정적 파일로만 구성합니다. 앱이 Supabase URL과 public anon key를 사용할 수는 있지만, 이 값들은 인증 시작과 public client bootstrap 용도입니다. owner access token, service role key, mail key, backup key, recipient email, private lesson JSON은 public repo와 Pages artifact에 들어가면 안 됩니다.

## 소유자 전용 사용 흐름

1. 소유자가 Google 계정으로 로그인합니다.
2. Supabase Auth 세션이 만들어집니다.
3. Edge Function과 DB RPC가 허용된 owner UID/session인지 다시 확인합니다.
4. owner action envelope로 CRUD, reader, schedule, mail status, import/export/restore를 호출합니다.
5. 익명 사용자는 lesson content, schedule snapshot, search index, draft/trash, backup data를 볼 수 없습니다.

주요 owner 기능:

- lesson CRUD: 초안 저장, 게시, 게시 취소, 휴지통, 복원, 복제
- schedule: 시작일 이후 자동 일정, future override, future rebuild
- reader: 오늘 글, 특정 lesson, snapshot, history, search
- mail: daily/test/resend job 상태 확인, uncertain 수동 재시도
- backup/import: preview 기본, 명시적 commit 때만 쓰기

상세 API는 [docs/API.md](docs/API.md)를 봅니다.

## 로컬 설치와 검증

Node.js 24를 사용합니다.

```bash
npm ci
node --test --test-concurrency=1 tests/*.test.js
npm run build
```

`npm run build`는 공유 renderer/Edge용 산출물을 포함해 `dist/`를 생성합니다. GitHub Pages workflow도 같은 원칙으로 테스트 후 `dist/`만 업로드합니다.

Apps Script 발송기는 별도로 빌드합니다.

```bash
npm run build:mail
```

생성된 `apps-script/dist/Code.gs`를 기존 Google Apps Script 프로젝트에 붙여 넣습니다. 실제 활성화 절차와 mail/backup/import runbook은 [docs/OPERATIONS.md](docs/OPERATIONS.md)를 따릅니다.

## GitHub Pages 배포

`.github/workflows/pages.yml`은 public repo용입니다.

- `main` push 또는 수동 실행에서만 동작
- Node 24로 `npm ci` 실행
- Docker가 있는 Ubuntu runner에서 integration test를 직렬 실행
- `npm run build` 실행
- `dist/`만 Pages artifact로 업로드/배포

이 workflow는 Supabase 배포, DB migration 적용, Edge Function 배포, secret 설정을 하지 않습니다. 그런 작업은 별도 승인과 별도 secret 준비가 필요합니다.

## 백업과 private archive

public repo의 Pages workflow는 백업을 만들지 않습니다. 백업은 private `Daily_CS-archive` 저장소에서 export-only key로 실행해야 합니다. private archive workflow는 private 저장소 guard, scoped backup key, GitHub token contents write 권한만 사용합니다.

public repo에 두면 안 되는 것:

- 실제 owner email
- Supabase service role key
- owner access token
- Apps Script mail key
- backup export key
- 원본 365개 lesson 데이터 또는 백업 JSON
- 실제 메일 본문/수신자 로그

## 문서

- [docs/API.md](docs/API.md): owner/mail/backup API contract
- [docs/OPERATIONS.md](docs/OPERATIONS.md): GAS, backup, import, restore 운영 절차