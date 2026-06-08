# Claude API 프록시 & 대시보드

Claude Code(또는 Anthropic SDK)가 `api.anthropic.com`으로 보내는 API 요청을 가로채서 실시간으로 확인할 수 있는 로컬 프록시 서버입니다.  
웹 대시보드와 MCP 서버를 함께 제공하여 요청/응답 내용, 토큰 사용량, 비용 추정치를 바로 분석할 수 있습니다.

---

## 주요 기능

- **HTTP 프록시** — Claude API 요청을 투명하게 중계하면서 캡처
- **실시간 웹 대시보드** — WebSocket으로 요청/응답을 실시간 스트리밍 표시
- **MCP 서버** — Claude Code 안에서 직접 캡처된 요청을 검색·분석
- **토큰 사용량 & 비용 추정** — 모델별 단가 기반 비용 계산
- **SSE 스트리밍 지원** — 스트리밍 응답도 청크 단위로 저장 및 파싱
- **API 키 마스킹** — 로그에 노출되는 인증 헤더를 자동으로 가립니다

---

## 포트 구성

| 포트 | 역할 |
|------|------|
| `8080` | HTTP 프록시 — Claude API 요청을 이 포트로 보내면 가로채서 Anthropic으로 전달 |
| `3000` | 웹 대시보드 + REST API (`/api/requests`) |
| `8081` | WebSocket 서버 — 대시보드에 실시간 이벤트 전송 |

---

## 설치 방법

### 사전 요구사항

- [Node.js](https://nodejs.org) v18 이상

### 의존성 설치

```bash
git clone https://github.com/chunkwon-park/study-claude.git
cd study-claude
npm install
```

---

## 실행 방법

### 1. 프록시 서버 시작

```bash
npm start
```

정상 실행 시 다음과 같이 출력됩니다:

```
  Proxy     →  http://localhost:8080
  Dashboard →  http://localhost:3000
  WebSocket →  ws://localhost:8081

  Run Claude Code with:
  ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

### 2. 웹 대시보드 열기

브라우저에서 http://localhost:3000 접속

### 3. Claude Code 트래픽 연결

새 터미널에서 아래와 같이 환경변수를 지정하여 Claude Code를 실행합니다:

```bash
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

이후 Claude Code를 사용하면 모든 API 요청이 프록시를 거쳐 대시보드에 표시됩니다.

---

## MCP 서버 사용 방법

MCP 서버를 사용하면 Claude Code 대화 중에 직접 캡처된 요청을 조회하고 분석할 수 있습니다.

### 자동 연결

프로젝트 루트의 `.mcp.json`이 Claude Code에 MCP 서버를 자동으로 등록합니다.  
프록시(`npm start`)가 실행 중인 상태에서 Claude Code를 열면 자동으로 연결됩니다.

### 수동 실행

```bash
npm run mcp
# 또는
node mcp.mjs
```

> **주의:** MCP 서버는 `proxy.js`가 먼저 실행 중이어야 합니다 (포트 3000에서 REST API 제공).

### 사용 가능한 MCP 도구

| 도구 | 설명 |
|------|------|
| `list_requests` | 캡처된 전체 요청 목록 조회 (ID, 메서드, 경로, 상태, 소요시간) |
| `get_request` | 특정 요청의 전체 상세 정보 (헤더, 바디, 응답) |
| `get_response_text` | 응답에서 텍스트 추출 (SSE 스트리밍 응답 파싱 포함) |
| `analyze_request` | 모델, 토큰 사용량, 캐시 히트, 예상 비용 분석 |
| `search_requests` | HTTP 메서드, 상태 코드, 경로로 요청 필터링 |
| `clear_requests` | 캡처된 요청 전체 삭제 |

---

## REST API

대시보드 서버(포트 3000)가 제공하는 HTTP API입니다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `GET` | `/api/requests` | 전체 요청 목록 |
| `GET` | `/api/requests/:id` | 특정 요청 상세 조회 |
| `DELETE` | `/api/requests` | 전체 요청 삭제 |

---

## 구조

```
├── proxy.js          # 프록시 + 대시보드 + WebSocket 서버 (메인)
├── mcp.mjs           # MCP 서버
├── public/
│   ├── index.html    # 대시보드 UI
│   └── app.js        # 대시보드 프론트엔드 로직
├── package.json
└── .mcp.json         # Claude Code MCP 자동 등록 설정
```

---

## 주의사항

- **인메모리 저장**: 최근 50개 요청만 RAM에 보관하며, 서버 재시작 시 초기화됩니다.
- **인증 없음**: 대시보드와 API는 인증이 없습니다. 로컬 전용으로만 사용하고 외부에 포트를 노출하지 마세요.
- **API 키 보안**: 로그에는 인증 헤더 앞 14자 + `****` 형태로 마스킹되어 표시됩니다.
