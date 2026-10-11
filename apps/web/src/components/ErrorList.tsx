import { errorMessages } from "../api/client";
import type { Errors } from "../api/types";

export function ErrorList({ errors }: { errors: Errors | null }) {
  if (!errors) return null;
  const msgs = errorMessages(errors);
  if (msgs.length === 0) return null;
  return (
    <ul className="error-messages">
      {msgs.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}
