const OWNER_EMAIL = "owner@example.invalid";

const baseLesson = {
  week: 1,
  track: "common",
  level: "foundation",
  versionNote: "합성 개발 데이터입니다. 실제 수업 원문이 아닙니다.",
  sources: [
    {
      title: "Synthetic Reference",
      url: "https://example.com/reference",
      note: "테스트 전용 출처"
    }
  ]
};

const MOCK_RECORDS = [
  {
    id: "lsn-synthetic-001",
    state: "published",
    version: 3,
    legacyAlias: "001",
    publishedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-10T08:00:00.000Z",
    lesson: {
      ...baseLesson,
      id: "lsn-synthetic-001",
      legacyAlias: "001",
      order: 1,
      category: "database",
      title: "합성 트랜잭션 격리 노트",
      summary: "테스트용 원장 변경 예시로 격리와 원자성을 점검합니다.",
      keywords: ["트랜잭션", "격리", "원자성"],
      question: "원장 변경에서 커밋 직전 장애가 나면 무엇을 보장해야 하나요?",
      explanation: [
        "트랜잭션은 함께 성공하거나 함께 취소되는 경계입니다.",
        "격리 수준은 동시에 실행되는 작업이 서로 어떻게 보이는지를 정합니다.",
        "감사 가능한 시스템에서는 복구 로그와 커밋 기록이 같은 결론을 내야 합니다."
      ],
      example: {
        language: "sql",
        description: "합성 계좌 테이블에서 차감과 입금을 같은 경계에 둡니다.",
        code: "BEGIN;\nUPDATE synthetic_account SET balance = balance - 1000 WHERE id = 1;\nUPDATE synthetic_account SET balance = balance + 1000 WHERE id = 2;\nCOMMIT;"
      },
      answer: "부분 반영 없이 모두 반영되거나 모두 취소되어야 하며, 장애 뒤에도 로그를 기준으로 같은 상태로 복구되어야 합니다.",
      pitfalls: ["출금 성공만 기록하면 합계가 깨집니다.", "격리 수준 이름만 외우면 실제 현상을 설명하기 어렵습니다."],
      followUps: [
        { question: "REDO와 UNDO는 언제 쓰나요?", answer: "커밋 여부와 디스크 반영 여부를 기준으로 재실행 또는 되돌리기를 선택합니다." },
        { question: "격리 수준은 왜 성능과 함께 보나요?", answer: "강한 격리는 충돌을 줄이지만 대기와 잠금 비용을 키울 수 있기 때문입니다." }
      ],
      quiz: {
        question: "원자성을 가장 잘 설명한 것은?",
        choices: ["부분 성공 허용", "모두 성공 또는 모두 실패", "항상 직렬 실행", "락 없는 실행"],
        answerIndex: 1,
        explanation: "원자성은 작업 묶음의 all-or-nothing 보장입니다."
      },
      comparison: {
        headers: ["상황", "우선순위"],
        rows: [
          ["조회 화면", "읽기 일관성"],
          ["원장 반영", "정합성과 감사"]
        ]
      }
    }
  },
  {
    id: "lsn-synthetic-002",
    state: "draft",
    version: 2,
    legacyAlias: "002",
    updatedAt: "2026-09-12T08:30:00.000Z",
    lesson: {
      ...baseLesson,
      id: "lsn-synthetic-002",
      legacyAlias: "002",
      order: 2,
      category: "network-security",
      title: "합성 TLS 핸드셰이크 메모",
      summary: "인증서 검증과 세션 키 합의를 면접 답변 흐름으로 정리합니다.",
      keywords: ["TLS", "인증서", "키 교환"],
      document: {
        kind: "markdown",
        markdown: "## 면접 질문\nTLS는 서버를 어떻게 신뢰하나요?\n\n## 핵심 설명\n- 클라이언트는 인증서 체인을 검증합니다.\n- 합성 데이터라 실제 강의 내용은 포함하지 않습니다.\n\n```java\nList<String> certificates = List.of(\"synthetic\");\n```\n\n[안전한 링크](https://example.com/tls)"
      }
    }
  },
  {
    id: "lsn-synthetic-003",
    state: "trash",
    version: 1,
    legacyAlias: "003",
    updatedAt: "2026-09-11T07:00:00.000Z",
    lesson: {
      ...baseLesson,
      id: "lsn-synthetic-003",
      legacyAlias: "003",
      order: 3,
      category: "algorithms",
      title: "합성 큐 복습",
      summary: "삭제 확인 흐름을 검증하기 위한 휴지통 항목입니다.",
      keywords: ["큐", "복습", "합성"],
      question: "큐는 어떤 순서를 보장하나요?",
      explanation: ["먼저 들어온 항목이 먼저 나갑니다."],
      example: { language: "text", description: "대기열 예시", code: "enqueue A\nenqueue B\ndequeue A" },
      answer: "FIFO 순서를 보장합니다.",
      pitfalls: ["스택과 혼동하지 않습니다."],
      followUps: [{ question: "언제 쓰나요?", answer: "작업 대기열에 씁니다." }],
      quiz: { question: "FIFO 구조는?", choices: ["스택", "큐"], answerIndex: 1, explanation: "큐입니다." }
    }
  }
];

const MOCK_SCHEDULE = {
  startDate: "2026-09-15",
  timeZone: "Asia/Seoul",
  sendHour: 9,
  paused: false,
  tomorrowOverrideLessonId: "",
  updatedAt: "2026-09-10T08:00:00.000Z"
};

const MOCK_MAIL = {
  paused: false,
  lastRunAt: null,
  nextWindow: "2026-09-15T00:00:00.000Z",
  logs: [
    { at: "2026-09-10T08:00:00.000Z", level: "info", message: "합성 메일 큐가 준비되었습니다." }
  ]
};

module.exports = { MOCK_MAIL, MOCK_RECORDS, MOCK_SCHEDULE, OWNER_EMAIL };
