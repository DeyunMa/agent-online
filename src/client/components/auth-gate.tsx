import { LoaderCircle, TerminalSquare } from "lucide-react";
import { type FormEvent, useState } from "react";

import { authClient } from "../auth";

type AuthMode = "sign-in" | "sign-up";

export function AuthLoadingScreen() {
  return (
    <main className="auth-shell">
      <div className="auth-loading" role="status">
        <TerminalSquare aria-hidden="true" size={22} />
        <LoaderCircle aria-hidden="true" className="spin" size={18} />
        <span>Checking your session</span>
      </div>
    </main>
  );
}

export function AuthGate({
  onAuthenticated,
  sessionError,
}: {
  onAuthenticated: () => Promise<void>;
  sessionError: string | null;
}) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();
    const normalizedName = name.trim();

    if (!normalizedEmail) {
      setFormError("Enter your email address.");
      return;
    }
    if (mode === "sign-up" && !normalizedName) {
      setFormError("Enter a display name.");
      return;
    }
    if (password.length < 8) {
      setFormError("Password must contain at least 8 characters.");
      return;
    }

    setFormError(null);
    setIsSubmitting(true);

    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({
              email: normalizedEmail,
              password,
            })
          : await authClient.signUp.email({
              email: normalizedEmail,
              name: normalizedName,
              password,
            });

      if (result.error) {
        setFormError(authErrorMessage(result.error));
        return;
      }

      await onAuthenticated();
    } catch {
      setFormError("Authentication is temporarily unavailable.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    setFormError(null);
  }

  return (
    <main className="auth-shell">
      <section aria-labelledby="auth-title" className="auth-panel">
        <div className="auth-brand">
          <TerminalSquare aria-hidden="true" size={21} />
          <span>Agent Online</span>
        </div>
        <div className="auth-heading">
          <p className="eyebrow">HOSTED CODING AGENT</p>
          <h1 id="auth-title">{mode === "sign-in" ? "Sign in" : "Create account"}</h1>
          <p>Use email and password to access your projects.</p>
        </div>

        <div aria-label="Authentication mode" className="auth-mode" role="tablist">
          <button
            aria-controls="auth-form"
            aria-selected={mode === "sign-in"}
            className={
              mode === "sign-in" ? "auth-mode-option auth-mode-option-active" : "auth-mode-option"
            }
            id="auth-sign-in-tab"
            onClick={() => changeMode("sign-in")}
            role="tab"
            type="button"
          >
            Sign in
          </button>
          <button
            aria-controls="auth-form"
            aria-selected={mode === "sign-up"}
            className={
              mode === "sign-up" ? "auth-mode-option auth-mode-option-active" : "auth-mode-option"
            }
            id="auth-sign-up-tab"
            onClick={() => changeMode("sign-up")}
            role="tab"
            type="button"
          >
            Register
          </button>
        </div>

        {sessionError ? (
          <p className="auth-session-note" role="status">
            {sessionError}
          </p>
        ) : null}

        <form
          aria-labelledby={mode === "sign-in" ? "auth-sign-in-tab" : "auth-sign-up-tab"}
          className="auth-form"
          id="auth-form"
          onSubmit={(event) => void submit(event)}
          role="tabpanel"
        >
          {mode === "sign-up" ? (
            <div className="form-field">
              <label htmlFor="auth-name">Display name</label>
              <input
                autoComplete="name"
                disabled={isSubmitting}
                id="auth-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </div>
          ) : null}
          <div className="form-field">
            <label htmlFor="auth-email">Email</label>
            <input
              autoComplete="email"
              disabled={isSubmitting}
              id="auth-email"
              inputMode="email"
              name="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@example.com"
              type="email"
              value={email}
            />
          </div>
          <div className="form-field">
            <label htmlFor="auth-password">Password</label>
            <input
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              disabled={isSubmitting}
              id="auth-password"
              minLength={8}
              name="password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </div>
          {formError ? (
            <p className="auth-error" role="alert">
              {formError}
            </p>
          ) : null}
          <button className="primary-action auth-submit" disabled={isSubmitting} type="submit">
            {isSubmitting ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : null}
            <span>
              {isSubmitting ? "Working" : mode === "sign-in" ? "Sign in" : "Create account"}
            </span>
          </button>
        </form>
      </section>
    </main>
  );
}

export function authErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === "This deployment is invite-only."
  ) {
    return "This deployment is invite-only.";
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (error.code === "USER_ALREADY_EXISTS") {
      return "This email is already registered.";
    }
    if (error.code === "INVALID_EMAIL_OR_PASSWORD") {
      return "Email or password is incorrect.";
    }
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    if (error.message === "Invalid email or password") {
      return "Email or password is incorrect.";
    }
    if (error.message === "User already exists") {
      return "This email is already registered.";
    }
  }

  return "Authentication request could not be completed.";
}
