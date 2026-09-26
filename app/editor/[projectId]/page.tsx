import type { Metadata } from "next";
import { EditorShell } from "@/components/editor/EditorShell";

export const metadata: Metadata = { title: "Editor — OpenSAM Studio" };

export default async function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <EditorShell projectId={projectId} />;
}
