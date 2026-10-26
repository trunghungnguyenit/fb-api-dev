import { SkelHeader, SkelLines, SkelStats, Waiting } from "./skeleton";

// What shows while any page without a loading screen of its own is being prepared (the overview, and the pages below that
// do not name theirs).
export default function Loading() {
  return <Waiting>
    <SkelHeader title="Tổng quan" />
    <SkelStats />
    <section className="panel"><SkelLines lines={5} /></section>
  </Waiting>;
}
