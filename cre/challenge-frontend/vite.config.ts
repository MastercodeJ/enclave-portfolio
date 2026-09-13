import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    define: {
      "import.meta.env.CONTRACT_ADDRESS": JSON.stringify(env.CONTRACT_ADDRESS),
      "import.meta.env.VETH_ADDRESS": JSON.stringify(env.VETH_ADDRESS),
      "import.meta.env.VUSD_ADDRESS": JSON.stringify(env.VUSD_ADDRESS),
      "import.meta.env.RPC_URL": JSON.stringify(env.RPC_URL),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    server: {
      fs: { allow: [".."] },
    },
  };
});
