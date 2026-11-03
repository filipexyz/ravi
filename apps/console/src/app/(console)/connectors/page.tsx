import { ConnectorsScreen } from "@/features/connectors/connectors-screen";

/** `?project=` from older links is ignored: connections belong to the person, not a project. */
export default function ConnectorsPage() {
  return <ConnectorsScreen />;
}
