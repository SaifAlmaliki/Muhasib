"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInSchema } from "@/app/lib/schema";
import { signIn } from "@/actions/auth";

export default function SignInPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({ resolver: zodResolver(signInSchema) });

  useEffect(() => {
    setFormError(null);
  }, []);

  const onSubmit = async (values) => {
    setSubmitting(true);
    setFormError(null);
    try {
      const result = await signIn(values);
      if (!result.success) {
        setFormError(result.error || "Failed to sign in");
        return;
      }
      toast.success("Welcome back");
      router.push("/dashboard");
      router.refresh();
    } catch (error) {
      setFormError(error.message || "Failed to sign in");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-lg border bg-white p-8 shadow-sm">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Email</label>
          <Input type="email" autoComplete="email" {...register("email")} />
          {errors.email && (
            <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">Password</label>
          <Input
            type="password"
            autoComplete="current-password"
            {...register("password")}
          />
          {errors.password && (
            <p className="mt-1 text-sm text-red-600">
              {errors.password.message}
            </p>
          )}
        </div>

        {formError && (
          <p className="text-sm text-red-600" role="alert">
            {formError}
          </p>
        )}

        <Button type="submit" disabled={submitting} className="w-full">
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-600">
        No account?{" "}
        <Link href="/sign-up" className="text-blue-600 hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
