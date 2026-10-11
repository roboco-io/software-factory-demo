import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { useLocation } from "react-router";
import { API_BASE, ApiFailure, createClient } from "../api/client";
import type { Errors } from "../api/types";
import { ErrorList } from "./ErrorList";

export const FEEDBACK_MAX = 2000;
const PATH_MAX = 200;

// HashRouter 경로를 API가 받는 "/#/..." 형식으로 바꾼다(spec 7.1.3).
export function feedbackPath(pathname: string): string {
  return `/#${pathname}`.slice(0, PATH_MAX);
}

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const PANEL: CSSProperties = {
  background: "#fff",
  padding: "1.5rem",
  borderRadius: "4px",
  width: "min(90vw, 480px)",
};

export function Footer() {
  const [open, setOpen] = useState(false);
  return (
    <footer>
      <div className="container">
        <a href="#/" className="logo-font">
          conduit
        </a>
        <span className="attribution">소프트웨어 팩토리 데모</span>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary pull-xs-right"
          onClick={() => setOpen(true)}
        >
          피드백
        </button>
      </div>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </footer>
  );
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  // 익명 피드백이다. 로그인 토큰을 붙이지 않는 별도 클라이언트를 쓴다.
  const client = useMemo(() => createClient(API_BASE, () => null), []);
  const { pathname } = useLocation();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [errors, setErrors] = useState<Errors | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const length = body.trim().length;

  useEffect(() => {
    textarea.current?.focus();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (length === 0 || length > FEEDBACK_MAX) return;
    setBusy(true);
    setErrors(null);
    try {
      await client.post("/feedback", {
        feedback: { body: body.trim(), path: feedbackPath(pathname) },
      });
      setSent(true);
    } catch (err) {
      setErrors(err instanceof ApiFailure ? err.errors : { feedback: ["could not be sent"] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
      style={OVERLAY}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div style={PANEL}>
        <h2 id="feedback-title">피드백</h2>
        {sent ? (
          <p>피드백을 보냈습니다. 고맙습니다.</p>
        ) : (
          <form onSubmit={submit}>
            <ErrorList errors={errors} />
            <fieldset className="form-group">
              <textarea
                ref={textarea}
                className="form-control"
                rows={5}
                aria-labelledby="feedback-title"
                placeholder="무엇이 불편했는지 알려 주세요"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </fieldset>
            <p>익명으로 보냅니다. 이름·이메일 같은 개인정보는 쓰지 마세요.</p>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || length === 0 || length > FEEDBACK_MAX}
            >
              보내기
            </button>
          </form>
        )}
        <button type="button" className="btn btn-outline-secondary" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  );
}
