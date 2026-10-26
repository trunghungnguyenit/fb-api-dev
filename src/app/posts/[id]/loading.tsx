import PageHeader from "@/app/page-header";
import { Skel, SkelCards, SkelLines, Waiting } from "@/app/skeleton";

export default function Loading() {
  return <Waiting label="Đang tải bài viết…">
    <PageHeader title="Chi tiết bài viết" subtitle={<Skel w={180} />} />
    <section className="panel"><SkelLines lines={5} /></section>
    <section className="panel"><Skel w={160} h={20} /><SkelCards count={3} /></section>
  </Waiting>;
}
