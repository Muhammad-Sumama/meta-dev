"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Play } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";

/** Creates a project from the bundled demo clip and opens it. */
export function DemoButton({ children = "Try Demo", ...props }: ButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  return (
    <Button
      {...props}
      disabled={loading || props.disabled}
      onClick={async () => {
        setLoading(true);
        try {
          const { project } = await api.createDemo();
          router.push(`/editor/${project.id}`);
        } catch (err) {
          const { title, hint } = errorText(err);
          toast.error(title, { description: hint });
          setLoading(false);
        }
      }}
    >
      {loading ? <Spinner className="size-4" /> : <Play className="fill-current" />}
      {children}
    </Button>
  );
}
