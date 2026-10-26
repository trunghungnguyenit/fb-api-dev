import PageHeader from "@/app/page-header";
import { Skel, SkelList, Waiting } from "@/app/skeleton";

export default function Loading() {
  return <Waiting label="Đang tải thông báo…">
    <PageHeader title="Thông báo" subtitle={<Skel w={200} />} />
    <section className="panel"><SkelList rows={5} /></section>
  </Waiting>;
}
