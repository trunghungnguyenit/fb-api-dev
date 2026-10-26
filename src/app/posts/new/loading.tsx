import PageHeader from "@/app/page-header";
import { Skel, SkelLines, Waiting } from "@/app/skeleton";

export default function Loading() {
  return <Waiting label="Đang tải form soạn bài…">
    <PageHeader title="Soạn bài mới" subtitle={<Skel w={220} />} />
    <section className="panel"><SkelLines lines={6} /></section>
  </Waiting>;
}
