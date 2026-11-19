// The people the robot signs in as. Locally no password is needed. On the deployed site the
// passwords come from environment variables only; they are never written to a file.
//
//   RPA_COORD_PASSWORD   password of coord1
//   RPA_BEN_PASSWORD     password of ben.ochieng
//   RPA_CHEN_PASSWORD    password of chen.li
export type RpaUser = {
  id: string;
  role: "coordinator" | "doctor";
  name: string;
  passwordEnv: string;
};

export const COORD: RpaUser = {
  id: "coord1",
  role: "coordinator",
  name: "Coordinator",
  passwordEnv: "RPA_COORD_PASSWORD",
};
export const BEN: RpaUser = {
  id: "ben.ochieng",
  role: "doctor",
  name: "Dr Ben Ochieng",
  passwordEnv: "RPA_BEN_PASSWORD",
};
export const CHEN: RpaUser = {
  id: "chen.li",
  role: "doctor",
  name: "Dr Chen Li",
  passwordEnv: "RPA_CHEN_PASSWORD",
};
