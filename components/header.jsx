import Link from "next/link";
import Image from "next/image";
import { PenBox, LayoutDashboard, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth";
import { signOut } from "@/actions/auth";

const Header = async () => {
  const user = await getCurrentUser();

  return (
    <header className="fixed top-0 w-full bg-white/80 backdrop-blur-md z-50 border-b">
      <nav className="container mx-auto px-4 py-4 flex items-center justify-between">
        <Link href="/">
          <Image
            src={"/logo.png"}
            alt="Welth Logo"
            width={200}
            height={60}
            className="h-12 w-auto object-contain"
          />
        </Link>

        <div className="hidden md:flex items-center space-x-8">
          {!user && (
            <>
              <a href="#features" className="text-gray-600 hover:text-blue-600">
                Features
              </a>
              <a
                href="#testimonials"
                className="text-gray-600 hover:text-blue-600"
              >
                Testimonials
              </a>
            </>
          )}
        </div>

        <div className="flex items-center space-x-4">
          {user ? (
            <>
              <Link
                href="/dashboard"
                className="text-gray-600 hover:text-blue-600 flex items-center gap-2"
              >
                <Button variant="outline">
                  <LayoutDashboard size={18} />
                  <span className="hidden md:inline">Dashboard</span>
                </Button>
              </Link>

              <Link
                href="/transaction/create"
                className="text-gray-600 hover:text-blue-600 flex items-center gap-2"
              >
                <Button className="flex items-center gap-2">
                  <PenBox size={18} />
                  <span className="hidden md:inline">Add Transaction</span>
                </Button>
              </Link>

              <span
                className="hidden md:inline text-sm text-gray-600"
                title={user.email}
              >
                {user.email}
              </span>

              <form action={signOut}>
                <Button type="submit" variant="outline">
                  <LogOut size={18} />
                  <span className="hidden md:inline">Sign out</span>
                </Button>
              </form>
            </>
          ) : (
            <Link href="/sign-in">
              <Button variant="outline">Login</Button>
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
};

export default Header;
