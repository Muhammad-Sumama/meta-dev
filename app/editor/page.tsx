import type { Metadata } from "next";
import { StartScreen } from "@/components/editor/StartScreen";

export const metadata: Metadata = { title: "Projects — OpenSAM Studio" };

export default function EditorIndexPage() {
  return <StartScreen />;
}
