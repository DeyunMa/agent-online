import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { authClient } from "../auth";
import { Button } from "./ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type AuthMode = "sign-in" | "sign-up";

const signInSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address.")
    .pipe(z.email("Enter a valid email address.")),
  name: z.string().trim(),
  password: z.string().min(8, "Password must contain at least 8 characters."),
});
const signUpSchema = signInSchema.extend({
  name: z.string().trim().min(1, "Enter a display name."),
});

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
  const form = useForm<z.infer<typeof signInSchema>>({
    defaultValues: { email: "", name: "", password: "" },
    resolver: zodResolver(mode === "sign-in" ? signInSchema : signUpSchema),
  });
  const { errors, isSubmitting } = form.formState;

  const submit = form.handleSubmit(async ({ email, name, password }) => {
    try {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, name, password });
      if (result.error) {
        form.setError("root", { message: authErrorMessage(result.error) });
        return;
      }
      await onAuthenticated();
    } catch {
      form.setError("root", { message: "Authentication is temporarily unavailable." });
    }
  });

  function changeMode(nextMode: unknown) {
    if (isSubmitting || (nextMode !== "sign-in" && nextMode !== "sign-up")) return;
    setMode(nextMode);
    form.clearErrors();
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
        <Tabs value={mode} onValueChange={changeMode}>
          <TabsList activateOnFocus aria-label="Authentication mode" className="my-5 h-10 w-full">
            <TabsTrigger value="sign-in" disabled={isSubmitting}>
              Sign in
            </TabsTrigger>
            <TabsTrigger value="sign-up" disabled={isSubmitting}>
              Register
            </TabsTrigger>
          </TabsList>
          {sessionError ? (
            <p className="auth-session-note" role="status">
              {sessionError}
            </p>
          ) : null}
          <TabsContent value={mode}>
            <form
              className="auth-form"
              id="auth-form"
              noValidate
              onSubmit={(event) => void submit(event)}
            >
              <FieldGroup>
                {mode === "sign-up" ? (
                  <Field data-invalid={!!errors.name} data-disabled={isSubmitting}>
                    <FieldLabel htmlFor="auth-name">Display name</FieldLabel>
                    <Input
                      {...form.register("name")}
                      autoComplete="name"
                      disabled={isSubmitting}
                      id="auth-name"
                      aria-invalid={!!errors.name}
                      aria-describedby={errors.name ? "auth-name-error" : undefined}
                    />
                    <FieldError id="auth-name-error" errors={[errors.name]} />
                  </Field>
                ) : null}
                <Field data-invalid={!!errors.email} data-disabled={isSubmitting}>
                  <FieldLabel htmlFor="auth-email">Email</FieldLabel>
                  <Input
                    {...form.register("email")}
                    autoComplete="email"
                    disabled={isSubmitting}
                    id="auth-email"
                    inputMode="email"
                    placeholder="name@example.com"
                    type="email"
                    aria-invalid={!!errors.email}
                    aria-describedby={errors.email ? "auth-email-error" : undefined}
                  />
                  <FieldError id="auth-email-error" errors={[errors.email]} />
                </Field>
                <Field data-invalid={!!errors.password} data-disabled={isSubmitting}>
                  <FieldLabel htmlFor="auth-password">Password</FieldLabel>
                  <Input
                    {...form.register("password")}
                    autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                    disabled={isSubmitting}
                    id="auth-password"
                    type="password"
                    aria-invalid={!!errors.password}
                    aria-describedby={errors.password ? "auth-password-error" : undefined}
                  />
                  <FieldError id="auth-password-error" errors={[errors.password]} />
                </Field>
              </FieldGroup>
              <FieldError errors={[errors.root]} />
              <Button className="auth-submit" disabled={isSubmitting} type="submit">
                {isSubmitting ? (
                  <LoaderCircle aria-hidden="true" className="spin" data-icon="inline-start" />
                ) : null}
                <span>
                  {isSubmitting ? "Working" : mode === "sign-in" ? "Sign in" : "Create account"}
                </span>
              </Button>
            </form>
          </TabsContent>
        </Tabs>
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
