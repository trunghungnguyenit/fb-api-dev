import PageHeader from "@/app/page-header";
import { Skel, SkelCards, SkelList, Waiting } from "@/app/skeleton";

export default function Loading() {
  return <Waiting wide label="Đang tải Insights…">
    <PageHeader title="Insights" subtitle="Số liệu của Fanpage từ Facebook: lượt xem, người theo dõi, tương tác" />
    <section className="panel">
      <div className="skel-filters"><Skel h={46} r={14} /><Skel h={46} r={14} /></div>
      <SkelCards count={6} />
    </section>
    <section className="panel"><Skel w={220} h={20} /><SkelList rows={4} /></section>
  </Waiting>;
}
