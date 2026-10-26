/**
 * Structured data for search engines (a <script type="application/ld+json"> block: data, never run as code, so the page's script
 * policy does not apply to it). `<` is written as < so that nothing inside the data could ever close the tag.
 */
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
