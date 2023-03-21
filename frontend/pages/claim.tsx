import { ethers } from "ethers";
import { useEffect, useRef, useState } from "react";

//const WS_SERVER = "ws://144.76.39.46:8548";

const WS_SERVER = "ws://localhost:8545";
const CLAIM_CONTRACT_ADDRESS = "0x59b670e9fA9D0A427751Af201D676719a970857b";
const TOKEN_ADDRESS = "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d";

const CLAIM_CONTRACT_ABI = [
    "function claimPeriodStart() public view returns (uint256)",
    "function claimPeriodEnd() public view returns (uint256)",
    "function claimableTokens(address addr) public view returns (uint256)",
    "function claim() public",
    "event HasClaimed(address indexed recipient, uint256 amount)",
];

const ERC20_ABI = [
    "function balanceOf(address owner) public view returns (uint256)",
    "function transfer(address to, uint256 value) public returns (bool)",
]

export default function Claim() {
    const provider = useRef<ethers.providers.WebSocketProvider>();
    const claimContract = useRef<ethers.Contract>();
    const arbTokenContract = useRef<ethers.Contract>();
    const claimPeriodStarted = useRef<Promise<boolean>>();

    const [blockNumber, setBlockNumber] = useState(0);
    const [wallets, setWallets] = useState<ethers.Wallet[]>([]);
    const [destinations, setDestinations] = useState<string[]>([]);
    const [lastError, setLastError] = useState<string>();
    const [nativeBalances, setNativeBalances] = useState<ethers.BigNumber[]>([]);
    const [claimableBalances, setClaimableBalances] = useState<ethers.BigNumber[]>([]);
    const [claimPeriodStart, setClaimPeriodStart] = useState<ethers.BigNumber>();
    const [transactionStates, setTransactionStateses] = useState<number[]>([]);
    const [inputText, setInputText] = useState(``);
    const [runApproved, setRunApproved] = useState(false);
    const [tips, setTips] = useState<boolean>(true);
    const [crazyMode, setCrazyMode] = useState<boolean>(false);

    useEffect(() => {
        provider.current = new ethers.providers.WebSocketProvider(WS_SERVER);
        claimContract.current = new ethers.Contract(CLAIM_CONTRACT_ADDRESS, CLAIM_CONTRACT_ABI, provider.current);
        arbTokenContract.current = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, provider.current);
        claimContract.current.claimPeriodStart().then((start: ethers.BigNumber) => {
            setClaimPeriodStart(start);
            claimPeriodStarted.current = new Promise((resolve, reject) => {
                if (!provider.current) reject("Provider is not ready");
                (provider.current as ethers.providers.WebSocketProvider).on("block", (blockNumber) => {
                    setBlockNumber(blockNumber);
                    if (blockNumber + 1 >= start.toNumber()) {
                        resolve(true);
                    }
                });
            });
        })        
    }, []);

    useEffect(() => {
        if (!runApproved) return;
        const startStateMachine = async (index: number, states: number[]) => {
            if (!provider.current || !claimContract.current || !arbTokenContract.current) return;
            let nonce = await provider.current.getTransactionCount(wallets[index].address);
            console.log("nonce for", wallets[index].address, "is", nonce);
    
            const claimableBalance = await claimContract.current.claimableTokens(wallets[index].address);
            console.log("claimable balance for", wallets[index].address, "is", claimableBalance.toString());
    
            if (!claimableBalance.isZero()) {
                const claimTransaction = await claimContract.current.connect(wallets[index]).populateTransaction.claim({nonce: nonce, gasLimit: 100000});
                const signedClaimTransaction = await wallets[index].signTransaction(claimTransaction);
                nonce += 1;
                await claimPeriodStarted.current;

                states[index] = 1; setTransactionStateses([...states]);
                const tx = await provider.current.sendTransaction(signedClaimTransaction);
                if (!crazyMode) {
                    await tx.wait();
                }
            }
    
            const inWalletBalance = await arbTokenContract.current.balanceOf(wallets[index].address);
            console.log("in wallet balance for", wallets[index].address, "is", inWalletBalance.toString());
            
            if (!inWalletBalance.isZero()) {
                states[index] = 2; setTransactionStateses([...states]);
                const tx = await arbTokenContract.current.connect(wallets[index]).transfer(destinations[index], inWalletBalance, {nonce: nonce, gasLimit: 100000});
                nonce += 1;
                if (!crazyMode) {
                    await tx.wait();
                }
            }
    
            states[index] = 3; setTransactionStateses([...states]);
        }

        const transactionStates = new Array(wallets.length).fill(0);
        const promises = wallets.map((wallet, index) => {
            startStateMachine(index, transactionStates);
        })
    }, [wallets, provider, claimContract, runApproved, tips])

    const onSendToCexButtonPressed = () => {
        if (runApproved) return;
        if (!provider.current) {
            setLastError("Provider is not ready")
            return;
        }
        const lines = inputText.split('\n');
        if (lines.length < 1) {
            setLastError("No lines")
        }
        const infos: [ethers.Wallet, string][] = lines.filter(line => {
            return line.trim().match(/^0x[0-9a-f]{64},0x[0-9a-f]{40}$/i);
        }).map(line => {
            const [privateKey, address] = line.trim().split(',');
            console.log(privateKey, address)
            return [new ethers.Wallet(privateKey, provider.current).connect(provider.current), address];
        });
        setWallets(infos.map(info => info[0]));
        setDestinations(infos.map(info => info[1]));
        setNativeBalances(infos.map(info => ethers.BigNumber.from(0)));
        setClaimableBalances(infos.map(info => ethers.BigNumber.from(0)));
        setTransactionStateses(infos.map(info => 0));
        setRunApproved(true);
    }

    useEffect(() => {
        if (!provider.current || !claimContract.current) {
            return;
        }
        const promises = wallets.map((wallet, index) => {
            return wallet.getBalance();
        })
        Promise.all(promises).then((newBalances) => {
            console.log("balances updated", newBalances)
            setNativeBalances(newBalances);
        });

        const promises2 = wallets.map((wallet, index) => {
            return claimContract.current.claimableTokens(wallet.address);
        })
        Promise.all(promises2).then((newBalances) => {
            console.log("claimable balances updated", newBalances)
            setClaimableBalances(newBalances);
        });
    }, [wallets, provider, claimContract])

    return (<>
        <h1>Claim</h1>
        <p>Block number: {blockNumber}, claims start at block {claimPeriodStart?.toNumber()}</p>
        <h2>Вывод на CEX</h2>
        <p>Вставьте приватные ключи и адреса для депозита в форму ниже:</p>
        <p>
        <textarea cols={120} rows={15} onChange={(event) => setInputText(event.target.value)} value={inputText}>
        </textarea>
        </p>

        <p>
            <label><input type="checkbox" checked={tips} onChange={ () => { setTips(!tips); } }></input>Включить чаевые 0.1%</label>
            <label><input type="checkbox" checked={crazyMode} onChange={ () => { setCrazyMode(!crazyMode); } }></input>Не ждать подтверждения</label>
            <button onClick={() => { onSendToCexButtonPressed(); }}>Проверить</button>
        </p>
        <h2>Статус</h2>
        {lastError && <p>{lastError}</p>}
        <table>
            <thead>
            <tr>
                <th>Адрес</th>
                <th>Баланс</th>
                <th>$ARB баланс для клейма</th>
                <th>Ожидание клейма</th>
                <th>Клейм</th>
                <th>Перевод</th>
                <th>Готово</th>
            </tr>
            </thead>
            <tbody>
            {wallets.map((wallet, index) => {return (
                <tr key={index}>
                    <td>{wallet.address}</td>
                    <td>{nativeBalances[index]?.toString()}</td>
                    <td>{claimableBalances[index]?.toString()}</td>
                    <td>{transactionStates[index] >= 0 && <span>✅</span>}</td>
                    <td>{transactionStates[index] >= 1 && <span>✅</span>}</td>
                    <td>{transactionStates[index] >= 2 && <span>✅</span>}</td>
                    <td>{transactionStates[index] >= 3 && <span>✅</span>}</td>
                </tr>
            )})}
            </tbody>
        </table>
    </>)
}