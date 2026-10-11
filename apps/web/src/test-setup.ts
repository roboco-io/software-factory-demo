import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest의 globals가 꺼져 있어 testing-library의 자동 정리가 동작하지 않는다.
afterEach(cleanup);
