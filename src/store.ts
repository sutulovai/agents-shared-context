import type { Redis } from "ioredis";

export interface Owner {
  id: string;
  token: string;
  label: string;
}
export interface Participant {
  id: string;
  label: string;
  state: "active" | "waiting";
  paths: string[];
  expiresInMs: number;
  policy?: Policy & { scope: "project"; phase: "pending" | "exclusive" };
}
export interface Policy {
  mode: "work" | "stable-build";
  reason: string;
}
export type Operation =
  | "join"
  | "parallel"
  | "claim"
  | "stage"
  | "probe"
  | "finish"
  | "abandon"
  | "renew"
  | "leave"
  | "exclusive"
  | "share"
  | "who";
export interface Reply {
  status:
    | "active"
    | "waiting"
    | "acquired"
    | "conflict"
    | "lost"
    | "occupied"
    | "ok"
    | "full"
    | "exclusive"
    | "pending"
    | "read-only";
  sessions: Participant[];
  owner?: string;
  label?: string;
  path?: string;
  reason?: string;
}

// Redis 7.4 field expiration lets each session disappear independently, even when other sessions stay busy.
const transact = `
local key, op, id, token, label, ttl = KEYS[1], unpack(ARGV,1,5)
local function answer(status, sessions, owner, path, reason, ownerLabel)
  return cjson.encode({status=status, sessions=sessions, owner=owner, path=path, reason=reason, label=ownerLabel})
end
local value=redis.call('HGET',key,id)
local self=value and cjson.decode(value)
if self and self.token~=token and (op=='join' or op=='parallel') then return answer('occupied') end
if op~='who' and self and self.token~=token then return answer('lost') end
if op=='leave' then
  if not self then return answer('lost') end
  redis.call('HDEL',key,id)
  return answer('ok')
end
if op=='renew' then
  if not self then return answer('lost') end
  redis.call('HPEXPIRE',key,ttl,'FIELDS',1,id)
  return answer('ok')
end
if not self and op~='join' and op~='parallel' and op~='who' then return answer('lost') end
if not self and op~='who' and redis.call('HLEN',key)>=128 then return answer('full') end
local paths={}
local call=ARGV[6]
for i=10,#ARGV do paths[ARGV[i]]=true end
-- Exclusive work mode drains peers first, so their earlier file claims must not block the owner.
local override=self and self.policy and self.policy.phase=='exclusive' and self.policy.mode=='work'
local peers={}
local gate, gateOwner, gateLabel, draining
if op=='who' or op=='join' or op=='parallel' or op=='exclusive' or op=='claim' or op=='stage' or op=='probe' then
  local rows=redis.call('HGETALL',key)
  for i=1,#rows,2 do
    local p=cjson.decode(rows[i+1])
    if p.policy then gate=p.policy; gateOwner=rows[i]; gateLabel=p.label end
    if op=='exclusive' and (next(p.pending) or (p.kept['build:checkout'] and not (rows[i]==id and p.policy and p.policy.phase=='exclusive'))) then draining=rows[i] end
    if op=='who' or (rows[i]~=id and p.state=='active') then
      if op=='claim' or op=='stage' or op=='probe' then
        for _,f in ipairs(p.paths) do
          if paths[f] and not override then return answer('conflict',nil,rows[i],f,nil,p.label) end
        end
        if op=='probe' and not next(paths) and #p.paths>0 and not override then
          return answer('conflict',nil,rows[i],p.paths[1],nil,p.label)
        end
      elseif op=='who' or op=='join' then
        table.insert(peers,{id=rows[i],label=p.label,state=p.state,paths=p.paths,
          policy=p.policy and {scope='project',mode=p.policy.mode,reason=p.policy.reason,phase=p.policy.phase},
          expiresInMs=redis.call('HPTTL',key,'FIELDS',1,rows[i])[1]})
      end
    end
  end
end
if op=='who' then return answer('ok',peers) end
if op=='probe' then
  if not self or self.state~='active' then return answer('waiting') end
  if gate and gateOwner~=id and (gate.phase=='pending' or gate.mode~='stable-build' or not paths['build:checkout']) then
    return answer('read-only',nil,gateOwner,nil,gate.reason,gateLabel)
  end
  return answer('ok')
end
self=self or {token=token,state='waiting',paths={},label=label,kept={},pending={}}
local function collect(set)
  local result={}
  for f in pairs(set) do table.insert(result,f) end
  table.sort(result)
  return result
end
local status='ok'
if op=='parallel' or op=='join' then
  if gate and gateOwner~=id then status='read-only'
  else
    if op=='parallel' or #peers==0 then self.state='active' end
    status=self.state
  end
elseif op=='exclusive' then
  if gate and (gateOwner~=id or self.policy.request~=call) then return answer('read-only',nil,gateOwner,nil,gate.reason,gateLabel) end
  if self.state~='active' then return answer('waiting') end
  self.policy=self.policy or {request=call,mode=ARGV[7],reason=ARGV[8],phase='pending'}
  if not draining then self.policy.phase='exclusive' end
  status=self.policy.phase
  if status=='exclusive' and self.policy.mode=='stable-build' then self.kept['build:checkout']=true end
elseif op=='share' then
  if not self.policy or self.policy.request~=call then return answer('lost') end
  if self.policy.mode=='stable-build' and self.policy.phase=='exclusive' then self.kept['build:checkout']=nil end
  self.policy=nil
elseif op=='claim' or op=='stage' then
  if gate and (gateOwner~=id or gate.phase=='pending' or
    (gate.mode=='stable-build' and not paths['build:checkout'])) then return answer('read-only',nil,gateOwner,nil,gate.reason,gateLabel) end
  if ARGV[9]~='' and (not gate or gateOwner~=id or gate.request~=ARGV[9] or gate.phase~='exclusive') then return answer('lost') end
  if self.state~='active' then return answer('waiting') end
  if op=='claim' then
    for f in pairs(paths) do self.kept[f]=true end
  else
    local count=0
    for _ in pairs(self.pending) do count=count+1 end
    if count>=32 and not self.pending[call] then return answer('full') end
    for _,f in ipairs(self.pending[call] or {}) do paths[f]=true end
    self.pending[call]=collect(paths)
  end
  status='acquired'
elseif op=='finish' or op=='abandon' then
  if op=='finish' then for _,f in ipairs(self.pending[call] or {}) do self.kept[f]=true end end
  self.pending[call]=nil
end
local all={}
for f in pairs(self.kept) do all[f]=true end
for _,pending in pairs(self.pending) do for _,f in ipairs(pending) do all[f]=true end end
self.paths=collect(all)
if #self.paths>256 then return answer('full') end
redis.call('HSET',key,id,cjson.encode(self))
redis.call('HPEXPIRE',key,ttl,'FIELDS',1,id)
return answer(status,peers,status=='read-only' and gateOwner or (status=='pending' and draining or nil),nil,status=='read-only' and gate.reason or nil,status=='read-only' and gateLabel or nil)
`;

export async function change(
  redis: Redis,
  key: string,
  op: Operation,
  owner: Owner,
  paths: string[] = [],
  ttl = 600000,
  call = "",
  policy?: Policy,
  expected = "",
): Promise<Reply> {
  if (
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    paths.length > 256 ||
    paths.some((f) => !f || Buffer.byteLength(f) > 4096)
  ) {
    throw new RangeError("Invalid lease duration or resource set");
  }
  const raw = await redis.eval(
    transact,
    1,
    key,
    op,
    owner.id,
    owner.token,
    owner.label.slice(0, 100),
    ttl,
    call,
    policy?.mode ?? "",
    policy?.reason.slice(0, 160) ?? "",
    expected,
    ...paths,
  );
  const reply = JSON.parse(String(raw)) as Reply;
  if (!Array.isArray(reply.sessions)) reply.sessions = [];
  for (const peer of reply.sessions) if (!Array.isArray(peer.paths)) peer.paths = [];
  return reply;
}
