import Link from "next/link";
import { IconFeather } from "./icons";

/** The hero action of the app: shown in the header of the pages where a new post is the natural next step. */
export default function NewPostButton() {
  return <Link className="cta" href="/posts/new"><IconFeather />Soạn bài mới</Link>;
}
