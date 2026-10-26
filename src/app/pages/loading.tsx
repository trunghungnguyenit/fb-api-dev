import PageHeader from "@/app/page-header";
import { Skel, SkelList, Waiting } from "@/app/skeleton";

export default function Loading() {
  return <Waiting label="Đang tải Fanpage…">
    <PageHeader title="Fanpage" subtitle={<Skel w={200} />} />
    <section className="panel"><Skel w={180} h={20} /><SkelList rows={3} /></section>
  </Waiting>;
}
