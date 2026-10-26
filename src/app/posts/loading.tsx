import PageHeader from "@/app/page-header";
import { Skel, SkelList, Waiting } from "@/app/skeleton";

export default function Loading() {
  return <Waiting wide label="Đang tải danh sách bài viết…">
    <PageHeader title="Bài viết" subtitle={<Skel w={200} />} />
    <section className="panel">
      <div className="skel-tabs"><Skel w={150} h={46} r={14} /><Skel w={120} h={46} r={14} /><Skel w={130} h={46} r={14} /></div>
      <div className="skel-filters"><Skel h={46} r={14} /><Skel h={46} r={14} /></div>
      <SkelList rows={6} />
    </section>
  </Waiting>;
}
