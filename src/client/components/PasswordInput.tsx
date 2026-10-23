import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete = "current-password",
  autoFocus,
  required,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-wrap">
      <input
        id={id}
        className="input"
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required={required}
        minLength={undefined}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "パスワードを隠す" : "パスワードを表示"}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </div>
  );
}
